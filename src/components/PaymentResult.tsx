import { useState, useEffect, useRef } from "react";
import { useCreditsContext } from "../contexts/CreditsContext";
import { TosAcknowledgementModal } from "./TosAcknowledgementModal";
import "./PaymentResult.css";

type PaymentResultProps = {
  type: "success" | "canceled";
};

export function PaymentResult({ type }: PaymentResultProps) {
  const { refetch, startPolling } = useCreditsContext();
  const [verifyStatus, setVerifyStatus] = useState<"verifying" | "completed" | "error">("verifying");
  const [creditsGranted, setCreditsGranted] = useState<number | null>(null);
  const verifiedRef = useRef(false);
  const [tosAccepted, setTosAccepted] = useState<boolean | null>(null);
  const [showTosModal, setShowTosModal] = useState(false);
  const tosCheckedRef = useRef(false);

  useEffect(() => {
    if (type !== "success" || verifyStatus === "verifying" || tosCheckedRef.current) return;
    tosCheckedRef.current = true;
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("auth check failed");
        return res.json();
      })
      .then((data) => {
        if (data.user) {
          const accepted = !!data.user.tosAcceptedAt;
          setTosAccepted(accepted);
          if (!accepted) {
            setShowTosModal(true);
          }
        } else {
          setTosAccepted(false);
          setShowTosModal(true);
        }
      })
      .catch(() => {
        setTosAccepted(false);
        setShowTosModal(true);
      });
  }, [type, verifyStatus]);

  useEffect(() => {
    if (type !== "success" || verifiedRef.current) return;
    verifiedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");

    if (!sessionId) {
      setVerifyStatus("completed");
      refetch();
      startPolling();
      return;
    }

    let attempts = 0;
    const maxAttempts = 5;

    async function verifySession() {
      try {
        const res = await fetch(`/api/payments/verify-session?session_id=${encodeURIComponent(sessionId!)}`, {
          credentials: "include",
        });

        if (res.status === 404) {
          setVerifyStatus("completed");
          refetch();
          startPolling();
          return;
        }

        if (!res.ok) {
          throw new Error(`Verify failed: ${res.status}`);
        }
        const data = await res.json();

        if (data.status === "completed") {
          setVerifyStatus("completed");
          setCreditsGranted(data.credits);
          refetch();
          startPolling();
          return;
        }

        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(verifySession, 2000);
        } else {
          setVerifyStatus("completed");
          refetch();
          startPolling();
        }
      } catch {
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(verifySession, 2000);
        } else {
          setVerifyStatus("error");
          refetch();
          startPolling();
        }
      }
    }

    verifySession();
  }, [type, refetch, startPolling]);

  const goHome = () => {
    window.location.href = "/";
  };

  if (type === "canceled") {
    return (
      <div className="payment-result">
        <div className="payment-result-card">
          <div className="payment-result-icon payment-result-icon--canceled">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <h1 className="payment-result-title">Payment Canceled</h1>
          <p className="payment-result-desc">Your payment was not processed. No charges were made.</p>
          <button type="button" className="payment-result-btn" onClick={goHome}>
            Back to App
          </button>
        </div>
      </div>
    );
  }

  const canGoHome = verifyStatus !== "verifying" && tosAccepted === true;

  return (
    <div className="payment-result">
      <div className="payment-result-card">
        <div className="payment-result-icon payment-result-icon--success">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <h1 className="payment-result-title">Payment Successful!</h1>
        <p className="payment-result-desc">
          {verifyStatus === "verifying"
            ? "Verifying your payment and adding credits to your account..."
            : verifyStatus === "error"
            ? "Your payment was received. Credits may take a moment to appear in your balance."
            : creditsGranted
            ? `${creditsGranted} credits have been added to your account.`
            : "Your credits have been added to your account."}
        </p>
        <button
          type="button"
          className="payment-result-btn"
          onClick={goHome}
          disabled={!canGoHome}
        >
          Back to App
        </button>
      </div>
      {showTosModal && (
        <TosAcknowledgementModal
          onAccepted={() => {
            setTosAccepted(true);
            setShowTosModal(false);
          }}
        />
      )}
    </div>
  );
}
