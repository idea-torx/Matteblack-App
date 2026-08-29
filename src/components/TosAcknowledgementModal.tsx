import { useState } from "react";
import "./TosAcknowledgementModal.css";

type TosAcknowledgementModalProps = {
  onAccepted: () => void;
};

export function TosAcknowledgementModal({ onAccepted }: TosAcknowledgementModalProps) {
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    if (!checked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/accept-tos", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        throw new Error("Failed to accept Terms of Service");
      }
      onAccepted();
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div className="tos-modal-overlay">
      <div className="tos-modal">
        <div className="tos-modal-header">
          <div className="tos-modal-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <h2 className="tos-modal-title">Terms of Service</h2>
          <p className="tos-modal-subtitle">Please review and accept our Terms of Service and Privacy Policy to continue.</p>
        </div>

        <div className="tos-modal-scroll">
          <h4>Key Terms Summary</h4>
          <ul>
            <li>Teseract.studio is an AI-native platform. All generated content is probabilistic and may be inaccurate, incomplete, or non-unique.</li>
            <li>You are solely responsible for reviewing, validating, and approving all AI-generated content before use.</li>
            <li>You retain ownership of your Customer Input. Subject to limitations, you own Output Content generated from your input.</li>
            <li>We do NOT use your content to train AI models without your explicit consent.</li>
            <li>The Services are provided "as is" without warranties of any kind.</li>
            <li>Credits are non-refundable, non-transferable, and may not be exchanged for cash.</li>
            <li>Disputes are resolved through binding individual arbitration (class actions waived).</li>
          </ul>
          <p className="tos-modal-link-text">
            You can read the full{" "}
            <a href="/settings" target="_blank" rel="noopener noreferrer">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="/settings" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>{" "}
            in Settings at any time.
          </p>
        </div>

        <div className="tos-modal-footer">
          <label className="tos-modal-checkbox-label">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="tos-modal-checkbox"
            />
            <span>I have read and agree to the Terms of Service and Privacy Policy</span>
          </label>

          {error && <p className="tos-modal-error">{error}</p>}

          <button
            type="button"
            className="tos-modal-btn"
            disabled={!checked || submitting}
            onClick={handleAccept}
          >
            {submitting ? "Accepting..." : "Accept & Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
