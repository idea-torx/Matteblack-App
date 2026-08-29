import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { getInviteInfo, acceptInvite, type InviteInfo } from "../api/workspace";

type InviteState = "loading" | "info" | "accepting" | "accepted" | "error";

export function InvitePage({ token }: { token: string }) {
  const { user } = useAuth();
  const [state, setState] = useState<InviteState>("loading");
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await getInviteInfo(token);
      if (cancelled) return;
      if (res.error) {
        setState("error");
        setErrorMsg(res.error);
      } else if (res.invitation) {
        setInvite(res.invitation);
        setState("info");
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token]);

  const handleAccept = async () => {
    if (!user) {
      localStorage.setItem("invite_redirect", `/invite?token=${encodeURIComponent(token)}`);
      window.location.href = "/auth/login";
      return;
    }
    setState("accepting");
    const res = await acceptInvite(token);
    if (res.error) {
      setState("error");
      setErrorMsg(res.error);
    } else {
      setState("accepted");
      setTimeout(() => {
        window.location.href = "/";
      }, 2000);
    }
  };

  const formatExpiry = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs <= 0) return "Expired";
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `Expires in ${days} day${days > 1 ? "s" : ""}`;
    return `Expires in ${hours} hour${hours !== 1 ? "s" : ""}`;
  };

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
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Loading invitation...</h2>
          </>
        )}

        {state === "info" && invite && (
          <>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.05)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 24px",
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>You're invited</h2>
            <p style={{ color: "#a3a3a3", fontSize: 15, lineHeight: 1.6, marginBottom: 4 }}>
              <strong style={{ color: "#fff" }}>{invite.inviterName}</strong> has invited you to join
            </p>
            <p style={{ color: "#fff", fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
              {invite.workspaceName}
            </p>
            <p style={{ color: "#a3a3a3", fontSize: 14, marginBottom: 24 }}>
              Role: <strong style={{ color: "#e5e5e5" }}>{invite.role.charAt(0).toUpperCase() + invite.role.slice(1)}</strong>
              {invite.expiresAt && (
                <span style={{ marginLeft: 12, color: "#666" }}>{formatExpiry(invite.expiresAt)}</span>
              )}
            </p>
            {!user ? (
              <button
                type="button"
                onClick={handleAccept}
                style={{
                  padding: "12px 32px",
                  background: "#fff",
                  color: "#000",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Sign in to accept
              </button>
            ) : (
              <button
                type="button"
                onClick={handleAccept}
                style={{
                  padding: "12px 32px",
                  background: "#fff",
                  color: "#000",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Accept Invitation
              </button>
            )}
          </>
        )}

        {state === "accepting" && (
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
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Accepting invitation...</h2>
          </>
        )}

        {state === "accepted" && (
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
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Welcome to the team!</h2>
            <p style={{ fontSize: 14, color: "var(--text-muted, #888)" }}>Redirecting you to the team...</p>
          </>
        )}

        {state === "error" && (
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
              {errorMsg.toLowerCase().includes("superseded") ? "Link no longer valid" :
               errorMsg.toLowerCase().includes("expired") ? "Invitation expired" :
               errorMsg.toLowerCase().includes("accepted") ? "Already accepted" :
               errorMsg.toLowerCase().includes("revoked") ? "Invitation revoked" :
               "Invalid invitation"}
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-muted, #888)", lineHeight: 1.6, marginBottom: 24 }}>
              {errorMsg.toLowerCase().includes("superseded")
                ? "This invite link has been replaced by a newer one. Please ask your team admin to send you a fresh invitation."
                : errorMsg}
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
